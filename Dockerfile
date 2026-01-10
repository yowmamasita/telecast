# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /build

# Install templ CLI
RUN go install github.com/a-h/templ/cmd/templ@latest

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Generate templ files
RUN templ generate

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o telecast ./cmd/telecast

# Runtime stage
FROM alpine:3.21

WORKDIR /app

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates tzdata

# Copy binary and static files
COPY --from=builder /build/telecast .
COPY --from=builder /build/static ./static

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 8080

# Run
ENTRYPOINT ["./telecast"]
CMD ["-config", "/app/config.yaml"]
