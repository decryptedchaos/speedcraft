use std::time::Duration;

use serde_json::Value;

/// Tiny Docker Engine API client: HTTP/1.1 over the unix socket with
/// `Connection: close`, so a response is a single read to EOF. No client crate
/// and no TLS, which keeps the image small and the dependency tree short.
pub struct DockerEngine {
    pub socket: String,
}

pub struct EngineResponse {
    pub status: u16,
    pub body: String,
}

impl DockerEngine {
    pub fn new(socket: impl Into<String>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    pub async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<EngineResponse, String> {
        let payload = body.unwrap_or("");
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: docker\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        let exchange = async {
            let raw = self.exchange(head.as_bytes(), payload.as_bytes()).await?;
            parse_response(&raw)
        };
        match tokio::time::timeout(Duration::from_secs(30), exchange).await {
            Ok(result) => result,
            Err(_) => Err(format!("docker engine did not answer {method} {path}")),
        }
    }

    #[cfg(unix)]
    async fn exchange(&self, head: &[u8], body: &[u8]) -> Result<Vec<u8>, String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixStream;

        let mut stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|err| format!("docker socket {}: {err}", self.socket))?;
        stream
            .write_all(head)
            .await
            .map_err(|err| err.to_string())?;
        if !body.is_empty() {
            stream
                .write_all(body)
                .await
                .map_err(|err| err.to_string())?;
        }
        stream.flush().await.map_err(|err| err.to_string())?;

        let mut raw = Vec::with_capacity(4096);
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|err| err.to_string())?;
        Ok(raw)
    }

    #[cfg(not(unix))]
    async fn exchange(&self, _head: &[u8], _body: &[u8]) -> Result<Vec<u8>, String> {
        Err(format!(
            "docker socket {} is only reachable from a unix host",
            self.socket
        ))
    }

    pub async fn ping(&self) -> Result<(), String> {
        let response = self.call("GET", "/_ping", None).await?;
        if response.status == 200 {
            Ok(())
        } else {
            Err(format!("engine ping returned {}", response.status))
        }
    }

    pub async fn image_exists(&self, image: &str) -> Result<bool, String> {
        let response = self
            .call("GET", &format!("/images/{}/json", urlencode(image)), None)
            .await?;
        Ok(response.status == 200)
    }

    pub async fn create_container(&self, spec: &Value) -> Result<String, String> {
        let payload = serde_json::to_string(spec).map_err(|err| err.to_string())?;
        let response = self
            .call("POST", "/containers/create", Some(&payload))
            .await?;
        if response.status >= 300 {
            return Err(format!(
                "create failed with {}: {}",
                response.status, response.body
            ));
        }
        let parsed: Value = serde_json::from_str(&response.body)
            .map_err(|err| format!("create returned invalid json: {err}"))?;
        parsed
            .get("Id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "docker returned no container id".to_string())
    }

    pub async fn start(&self, id: &str) -> Result<(), String> {
        let response = self
            .call("POST", &format!("/containers/{id}/start"), None)
            .await?;
        if response.status < 300 {
            Ok(())
        } else {
            Err(format!("start failed with {}: {}", response.status, response.body))
        }
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let response = self
            .call("DELETE", &format!("/containers/{id}?force=1&v=1"), None)
            .await?;
        if response.status < 300 || response.status == 404 {
            Ok(())
        } else {
            Err(format!("remove failed with {}", response.status))
        }
    }

    pub async fn inspect(&self, id: &str) -> Result<Value, String> {
        let response = self
            .call("GET", &format!("/containers/{id}/json"), None)
            .await?;
        if response.status >= 300 {
            return Err(format!("inspect failed with {}", response.status));
        }
        serde_json::from_str(&response.body)
            .map_err(|err| format!("inspect returned invalid json: {err}"))
    }

    pub async fn list_by_label(&self, label: &str) -> Result<Vec<Value>, String> {
        let filters = serde_json::json!({ "label": [label] }).to_string();
        let path = format!("/containers/json?all=true&filters={}", urlencode(&filters));
        let response = self.call("GET", &path, None).await?;
        if response.status >= 300 {
            return Err(format!("list failed with {}", response.status));
        }
        let parsed: Value = serde_json::from_str(&response.body)
            .map_err(|err| format!("list returned invalid json: {err}"))?;
        Ok(parsed.as_array().cloned().unwrap_or_default())
    }
}

fn parse_response(raw: &[u8]) -> Result<EngineResponse, String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "malformed docker response".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("unexpected docker status line: {status_line}"))?;

    let mut chunked = false;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }

    let body = &raw[split + 4..];
    let text = if chunked {
        decode_chunked(body)?
    } else {
        String::from_utf8_lossy(body).to_string()
    };
    Ok(EngineResponse { status, body: text })
}

fn decode_chunked(mut data: &[u8]) -> Result<String, String> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "truncated chunk header".to_string())?;
        let header = String::from_utf8_lossy(&data[..line_end]).to_string();
        let size_text = header.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("invalid chunk size: {size_text}"))?;
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size {
            return Err("truncated chunk body".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.starts_with(b"\r\n") {
            data = &data[2..];
        }
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
