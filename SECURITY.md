# Security Policy

SentryBridge has no authentication. This is by design: it is meant to run on a private network, not on the internet.

## Supported deployment

- A private LAN you control.
- Remote access through a VPN such as WireGuard or Tailscale. If the VPN runs on the Docker host itself, add a port mapping on its VPN address; see [Access through a VPN](docs/guide/how-to/docker-compose.md#access-through-a-vpn).
- Ports published on the Docker host's LAN IP only (`JANUS_HOST_IP`, see the [Docker Compose guide](docs/guide/how-to/docker-compose.md)).

## Not supported

- A public IP address, or any host reachable from the internet (VPS, IPv6 without a firewall, DMZ).
- Port forwarding to the bridge.
- A reverse proxy without its own authentication in front of the bridge.
- Guest, shared, or otherwise untrusted networks.
- Hosting the bridge for third parties.

Docker-published ports bypass host firewalls such as `ufw`, because Docker manages its own iptables rules. A firewall rule on the host is not a substitute for binding to the LAN IP.

## Trust assumptions

- Everyone who can reach the web port has full control: they can read and change the config (including the stored PrusaLink password and Obico token), pause, resume, and cancel prints, upload files, start and delete prints, and view the camera.
- The configured Obico server can control the printer through the bridge and can make the bridge download G-code files.
- Anyone with access to the config volume or the Docker host can read the stored credentials.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting: open the [Security tab](https://github.com/reneleban/sentry-bridge/security) of the repository and choose "Report a vulnerability". Do not open a public issue for a vulnerability.

Reports about the missing authentication or about exposure caused by an unsupported deployment are out of scope.

## Disclaimer

The software is provided "as is", without warranty. See the disclaimer in [LICENSE](LICENSE) (MIT).
