FROM golang:1.27-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /master .

FROM alpine:3.20
WORKDIR /app
COPY --from=builder /master /app/master
EXPOSE 5000
CMD ["/app/master"]

