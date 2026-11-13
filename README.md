# OPNsense NOC

OPNsense NOC is a Tactical NOC dashboard for monitoring an OPNsense firewall and its downstream network. Explore a live topology, inspect uplinks, and track WAN throughput, CPU, memory, uptime, and per-device traffic history.

## Features

- Real-time SNMPv2c and SNMPv3 polling with WebSocket updates, a REST fallback, and a mock topology for evaluation.
- Interactive topology with traffic sparklines, connection highlighting, and right-click actions for devices and the canvas.
- Figma-style magnetic snapping, alignment guides, and equal spacing. Hold Shift to align to a parent or Alt for free movement. Layouts persist in the browser and can be imported or exported as JSON.
- English and Vietnamese interface with a language switch in the command bar.

The backend uses Node.js 26 LTS, TypeScript, Express, `ws`, and `net-snmp`. The frontend uses React 18, Vite, `@xyflow/react`, Dagre, and Tailwind CSS.

## Quick start

### Run directly on Windows, Linux, or macOS

Install Node.js 26 LTS. The repository pins 26.13.1 in `.nvmrc` and `.node-version`.

```sh
git clone https://github.com/vietnamvps/snmp_topo.git
cd snmp_topo
```

On Linux or macOS, create the local configuration files:

```sh
cp -n .env.example .env
cp -n config/devices.example.yaml config/devices.yaml
```

On Windows PowerShell:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
if (!(Test-Path config/devices.yaml)) { Copy-Item config/devices.example.yaml config/devices.yaml }
```

Install dependencies and start the dashboard:

```sh
npm ci --include=dev
npm start
```

Use `npm.cmd` in PowerShell if script execution is restricted. Open the loopback address printed by the server. Set `PORT` in `.env` to choose an explicit port. In Nexora, select Node.js 26 and the `start` script. Express serves the dashboard, REST API, and WebSocket from one origin.

### Run with Docker Compose

Create the same two local configuration files, then run:

```sh
docker compose up -d --build
docker compose logs -f opnsense-monitor
```

Compose publishes port 3000 on loopback by default. Set `BIND_IP` and `PUBLISH_PORT` in `.env` to change the host address and port. The container runs as an unprivileged user and mounts `config/devices.yaml` read-only. Give the container user read access to that file. To change device configuration, edit the host file and run `docker compose up -d --force-recreate`.

## Connect OPNsense

1. Install `os-net-snmp` under **System → Firmware → Plugins**. Enable **Services → NET-SNMP** on the management address and configure a read-only SNMP user. Prefer SNMPv3 `authPriv` with compatible authentication and encryption settings.
2. On the firewall interface receiving poller traffic, allow UDP port 161 from the poller's exact IP to the OPNsense management address. Place a block for all other sources to that destination and port above broad allow rules. Keep SNMP off the WAN.
3. Set the firewall's management IP and WAN `ifIndex` in the device configuration. Store the SNMP community or SNMPv3 keys in environment variables. Set `MOCK_MODE=false`, configure `DASHBOARD_TOKEN`, and restart. Set `DASHBOARD_ORIGIN` to the exact browser origin. The default for Docker live mode is HTTPS through a reverse proxy with WebSocket upgrades. For trusted LAN HTTP, use the explicit opt-in below.

## Security

Keep the dashboard on loopback or a trusted management network. Use an SSH tunnel or an HTTPS reverse proxy for remote access. Treat `.env` and `config/devices.yaml` as deployment data. See [SECURITY.md](SECURITY.md) for authentication, origin controls, and firewall rules.

### Run the published image

Create the local configuration files as above, set `PUBLISH_PORT=3100` in `.env` if port 3000 is already in use, and run:

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
docker compose -f docker-compose.ghcr.yml ps
```

The GitHub Actions workflow publishes a Linux AMD64 image to GHCR with a moving `latest` tag and a commit-specific `sha-<full-commit>` tag. After the first publication, the package owner can set visibility to Public to allow anonymous pulls. For a private package, authenticate to `ghcr.io` with a credential that has package read access.

### Use HTTP on a trusted LAN

For Docker, set these values in `.env` (replace the IP with your Docker host's LAN IP):

```dotenv
BIND_IP=192.168.1.20
PUBLISH_PORT=3100
ALLOW_INSECURE_LAN_HTTP=true
DASHBOARD_ORIGIN=http://192.168.1.20:3100
```

Keep a valid `DASHBOARD_TOKEN` in live mode. Remove the legacy `DASHBOARD_LAN_ORIGIN` entry and move its value to `DASHBOARD_ORIGIN`. HTTP requires a private or loopback IP literal. Restrict access to trusted clients because HTTP carries tokens, cookies, and telemetry without encryption. Recreate the service after editing the environment.
