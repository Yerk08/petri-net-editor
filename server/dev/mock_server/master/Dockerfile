FROM golang:1.27-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /master main.go

FROM alpine:3.20
WORKDIR /app
COPY --from=builder /master /app/master
EXPOSE 5000
CMD ["/app/master"]

