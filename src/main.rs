mod app;
mod config;
mod docker;
mod pool;
mod worker;

use std::time::Duration;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_max_idle_per_host(64)
        .tcp_nodelay(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
}

/// Container healthcheck for both roles: the worker answers on WORKER_PORT, the
/// app on PORT, and both bind only once they are ready to serve.
fn probe() -> i32 {
    let port = std::env::var("WORKER_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .or_else(|| {
            std::env::var("PORT")
                .ok()
                .and_then(|value| value.trim().parse::<u16>().ok())
        })
        .unwrap_or(3000);
    let address: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(address) => address,
        Err(_) => return 1,
    };
    match std::net::TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
        Ok(_) => 0,
        Err(_) => 1,
    }
}

#[tokio::main]
async fn main() {
    let role = std::env::args().nth(1).unwrap_or_else(|| "app".to_string());

    if role == "probe" {
        std::process::exit(probe());
    }

    let result = if role == "worker" {
        worker::run().await
    } else {
        app::run().await
    };

    if let Err(err) = result {
        eprintln!("[speedtest] {err}");
        std::process::exit(1);
    }
}
