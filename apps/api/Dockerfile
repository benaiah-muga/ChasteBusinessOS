# Build the Go HTTP API as a static binary, then ship only the executable.
ARG GO_VERSION=1.27.1

FROM golang:${GO_VERSION}-bookworm AS builder
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api/ ./
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/chaste-api ./cmd/api \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/chaste-jobs-worker ./cmd/jobs-worker \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/chaste-outbox-worker ./cmd/outbox-worker \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/chaste-marketing-email-worker ./cmd/marketing-email-worker \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/chaste-notification-email-worker ./cmd/notification-email-worker

FROM alpine:3.22 AS runner
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/chaste-api /usr/local/bin/chaste-api
COPY --from=builder /out/chaste-jobs-worker /usr/local/bin/chaste-jobs-worker
COPY --from=builder /out/chaste-outbox-worker /usr/local/bin/chaste-outbox-worker
COPY --from=builder /out/chaste-marketing-email-worker /usr/local/bin/chaste-marketing-email-worker
COPY --from=builder /out/chaste-notification-email-worker /usr/local/bin/chaste-notification-email-worker
USER 65532:65532
EXPOSE 8080
CMD ["/usr/local/bin/chaste-api"]
