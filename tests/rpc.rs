//! Exercises the compiled plugin process over the real RPC framing.
//!
//! The fixture plays the host side of CPR's plugin protocol using the same SDK
//! frame codecs, including registration, management and background maintenance.

use std::{process::Stdio, time::Duration};

use gateway_plugin_sdk::{
    CallBudgets, CallContext, Capability, Contributions, ErrorCode, Frame, FrameError, Handshake,
    Manifest, Message, PROTOCOL_VERSION, PluginFault, Stage,
    call::{management::ManagementResponse, registration::Registration},
    client::{read_frame, write_frame},
};
use serde_json::{Value, json};
use tokio::{
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

#[path = "rpc/pelican.rs"]
mod pelican;

const BIN: &str = env!("CARGO_BIN_EXE_cpr-pelican-test");
const STEP_TIMEOUT: Duration = Duration::from_secs(10);
const INSTANCE: &str = "test-instance";
const INCARNATION: &str = "test-incarnation";

fn manifest() -> Manifest {
    Manifest::from_author_slice(include_bytes!("../plugin.json")).expect("author manifest")
}

fn plugin_id() -> String {
    manifest().plugin_id().expect("plugin id")
}

fn contributions() -> Contributions {
    manifest().contributes
}

fn hello(protocol_version: u32, contributes: Contributions) -> Frame {
    Frame::control(Message::Hello {
        handshake: Handshake {
            protocol_version,
            artifact_sha256: "0".repeat(64),
            plugin_id: plugin_id(),
            instance_id: INSTANCE.into(),
            generation: 1,
            incarnation: INCARNATION.into(),
            configuration: json!({}),
            contributes,
        },
    })
}

struct Host {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    next_call_id: u64,
}

async fn spawn() -> Host {
    let mut child = Command::new(BIN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("plugin process starts");
    let stdin = child.stdin.take().expect("plugin stdin");
    let stdout = child.stdout.take().expect("plugin stdout");
    Host {
        child,
        stdin,
        stdout,
        next_call_id: 1,
    }
}

async fn start() -> Host {
    let mut host = spawn().await;
    write_frame(&mut host.stdin, &hello(PROTOCOL_VERSION, contributions()))
        .await
        .expect("Hello write");
    let ready = timeout(STEP_TIMEOUT, read_frame(&mut host.stdout))
        .await
        .expect("Ready timed out")
        .expect("Ready frame");
    assert!(ready.payload.is_empty());
    match ready.message {
        Message::Ready {
            protocol_version,
            incarnation,
            call_budgets,
        } => {
            assert_eq!(protocol_version, PROTOCOL_VERSION);
            assert_eq!(incarnation, INCARNATION);
            assert_eq!(call_budgets, CallBudgets::from([(Stage::Maintenance, 360_000)]));
        }
        other => panic!("expected Ready, got {other:?}"),
    }
    host
}

impl Host {
    async fn read(&mut self) -> Frame {
        timeout(STEP_TIMEOUT, read_frame(&mut self.stdout))
            .await
            .expect("plugin response timed out")
            .expect("plugin frame is valid")
    }

    async fn send(&mut self, frame: Frame) {
        write_frame(&mut self.stdin, &frame)
            .await
            .expect("plugin frame write");
    }

    async fn shutdown(mut self) {
        self.send(Frame::control(Message::Shutdown)).await;
        let status = timeout(STEP_TIMEOUT, self.child.wait())
            .await
            .expect("plugin shutdown timed out")
            .expect("plugin wait");
        assert!(status.success(), "plugin exited with {status}");
    }
}

fn call_context(id: u64, stage: Stage) -> CallContext {
    CallContext {
        request: None,
        call_id: id,
        instance_id: INSTANCE.into(),
        generation: 1,
        incarnation: INCARNATION.into(),
        stage,
        timeout_ms: 5_000,
        resource_stream: false,
        resource_scope_id: format!("scope-{id}"),
        request_id: Some(format!("req-{id}")),
        attempt_id: None,
        account_id: None,
        credential_revision: None,
    }
}

#[tokio::test]
async fn process_registers_only_management_and_maintenance() {
    let mut host = start().await;
    let (result, payload) = rpc_call(
        &mut host,
        "plugin.register",
        Stage::Registration,
        json!({}),
        Vec::new(),
        &mut |method, _, _| panic!("registration must not call the host: {method}"),
    )
    .await;
    let registration: Registration = serde_json::from_value(result).expect("plugin registration");
    assert!(payload.is_empty());
    let registered = registration.contributes;
    assert_eq!(registered.len(), 2);
    assert!(registered.contains_key(&Capability::Management));
    assert!(registered.contains_key(&Capability::Maintenance));
    host.shutdown().await;
}

async fn management_call(
    host: &mut Host,
    path: &str,
    input: Option<&Value>,
    callback: &mut impl FnMut(&str, Value, &[u8]) -> Result<(Value, Vec<u8>), PluginFault>,
) -> (u16, Value) {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let (result, payload) = rpc_call(
        host,
        "management.handle",
        Stage::Management,
        json!({
            "method": if input.is_some() { "POST" } else { "GET" },
            "path": path.trim_start_matches('/'),
            "query": query,
            "content_type": input.map(|_| "application/json"),
        }),
        input
            .map(|value| serde_json::to_vec(value).unwrap())
            .unwrap_or_default(),
        callback,
    )
    .await;
    let metadata: ManagementResponse = serde_json::from_value(result).unwrap();
    (metadata.status, serde_json::from_slice(&payload).unwrap())
}

async fn rpc_call(
    host: &mut Host,
    method: &str,
    stage: Stage,
    params: Value,
    payload: Vec<u8>,
    callback: &mut impl FnMut(&str, Value, &[u8]) -> Result<(Value, Vec<u8>), PluginFault>,
) -> (Value, Vec<u8>) {
    let id = host.next_call_id;
    host.next_call_id += 2;
    let mut context = call_context(id, stage);
    if matches!(stage, Stage::Maintenance | Stage::Registration) {
        context.request_id = None;
    }
    host.send(Frame {
        message: Message::Call {
            id,
            method: method.into(),
            context,
            params,
        },
        payload,
    })
    .await;
    loop {
        let frame = host.read().await;
        match frame.message {
            Message::Callback {
                id: callback_id,
                parent_id,
                method,
                params,
            } => {
                assert_eq!(parent_id, id);
                let reply = match callback(&method, params, &frame.payload) {
                    Ok((result, payload)) => Frame {
                        message: Message::Result {
                            id: callback_id,
                            result,
                        },
                        payload,
                    },
                    Err(error) => Frame::control(Message::Error {
                        id: callback_id,
                        error,
                    }),
                };
                host.send(reply).await;
            }
            Message::Suspend { .. } | Message::CallbackConsumed { .. } => {}
            Message::Resume {
                id: resume_id,
                epoch,
            } => {
                assert_eq!(resume_id, id);
                host.send(Frame::control(Message::Resumed { id, epoch }))
                    .await;
            }
            Message::Result {
                id: result_id,
                result,
            } if result_id == id => {
                return (result, frame.payload);
            }
            other => panic!("unexpected {method} frame {other:?}"),
        }
    }
}

#[tokio::test]
async fn process_rejects_mismatched_contribution() {
    let mut contributes = contributions();
    assert!(contributes.remove(&Capability::Maintenance).is_some());
    let mut host = spawn().await;
    host.send(hello(PROTOCOL_VERSION, contributes)).await;
    expect_no_ready(&mut host).await;
}

#[tokio::test]
async fn process_rejects_rpc_v6_handshake() {
    let mut host = spawn().await;
    host.send(hello(6, contributions())).await;
    expect_no_ready(&mut host).await;
}

async fn expect_no_ready(host: &mut Host) {
    match timeout(STEP_TIMEOUT, read_frame(&mut host.stdout)).await {
        Ok(Err(FrameError::Io(_))) => {}
        Ok(Ok(frame)) => panic!("plugin answered a rejected handshake: {frame:?}"),
        Ok(Err(error)) => panic!("unexpected frame error: {error}"),
        Err(_) => panic!("plugin did not exit after a rejected handshake"),
    }
    let status = timeout(STEP_TIMEOUT, host.child.wait())
        .await
        .expect("rejected handshake process did not exit")
        .expect("plugin wait");
    assert_eq!(
        status.code(),
        Some(1),
        "rejected handshake exit status: {status}"
    );
}
