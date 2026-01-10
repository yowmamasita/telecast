.PHONY: run build clean templ

templ:
	templ generate

run: templ
	go run ./cmd/telecast

build: templ
	go build -o telecast ./cmd/telecast

clean:
	rm -f telecast
