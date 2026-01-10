# Telecast

A self-hosted IPTV streaming application built with Go. Stream live TV from your Xtream Codes provider directly in your browser.

## Features

- Live TV streaming with HLS playback
- Channel list with category grouping
- Search channels by name
- Background channel sync (configurable interval, default 15 minutes)
- Stream proxying through backend (no CORS issues)
- HLS manifest URL rewriting
- Channel icon proxying
- Responsive sidebar + player layout
- Keyboard shortcuts (space/k: play/pause, f: fullscreen, m: mute)

## Tech Stack

- **Backend**: Go 1.22+ with net/http
- **Database**: SQLite (pure Go, no CGO)
- **Frontend**: HTMX + Templ templates
- **Player**: HLS.js
- **Styling**: Custom CSS

## Quick Start

### Binary

1. Clone and build:
```bash
git clone https://github.com/bensarmiento/telecast.git
cd telecast

# Install templ CLI
go install github.com/a-h/templ/cmd/templ@latest

# Generate templates
templ generate

# Build
go build -o telecast ./cmd/telecast
```

2. Create config file:
```bash
cp config.example.yaml config.yaml
# Edit config.yaml with your IPTV credentials
```

3. Run:
```bash
./telecast
```

4. Open http://localhost:8080 in your browser.

### Docker

1. Create `config.yaml`:
```yaml
server:
  host: "0.0.0.0"
  port: 8080

iptv:
  url: "http://your-iptv-server.com"
  username: "your-username"
  password: "your-password"

sync:
  interval: "15m"

database:
  path: "./data/telecast.db"
```

2. Run with docker-compose:
```bash
docker-compose up -d
```

3. Open http://localhost:8080 in your browser.

## Configuration

| Key | Description | Default |
|-----|-------------|---------|
| `server.host` | Server bind address | `0.0.0.0` |
| `server.port` | Server port | `8080` |
| `iptv.url` | Xtream Codes server URL | - |
| `iptv.username` | Xtream Codes username | - |
| `iptv.password` | Xtream Codes password | - |
| `sync.interval` | Channel refresh interval | `15m` |
| `database.path` | SQLite database path | `./data/telecast.db` |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Main page |
| GET | `/play/{streamID}` | Play a channel |
| GET | `/channels/search?q=` | Search channels (HTMX) |
| GET | `/api/stream?url=` | Proxy video stream |
| GET | `/api/image?url=` | Proxy channel icons |
| GET | `/api/channels` | List all channels (JSON) |
| GET | `/api/categories` | List all categories (JSON) |
| POST | `/api/sync` | Trigger manual sync |
| GET | `/api/sync/status` | Get sync status |

## Project Structure

```
telecast/
├── cmd/telecast/main.go       # Entry point
├── internal/
│   ├── config/                # YAML config parsing
│   ├── db/                    # SQLite database
│   ├── handlers/              # HTTP handlers
│   ├── proxy/                 # Stream proxy with HLS rewriting
│   ├── sync/                  # Background sync service
│   └── xtream/                # Xtream Codes API client
├── templates/                 # Templ templates
├── static/
│   ├── css/style.css          # Styles
│   └── js/player.js           # HLS.js player
├── config.yaml                # Config file
├── Dockerfile
└── docker-compose.yml
```

## Development

```bash
# Install templ CLI
go install github.com/a-h/templ/cmd/templ@latest

# Generate templates (run after editing .templ files)
templ generate

# Build and run
go build -o telecast ./cmd/telecast && ./telecast
```

## License

MIT
