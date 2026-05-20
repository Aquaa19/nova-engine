# nova-engine/Dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install core runtimes and compilers
RUN apt-get update && apt-get install -y \
    python3 \
    nodejs \
    npm \
    openjdk-17-jdk \
    gcc \
    g++ \
    bash \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create an unprivileged user for the sandbox
RUN useradd -m -u 1000 -s /bin/bash student

# Setup the default working directory
WORKDIR /workspace
USER student
