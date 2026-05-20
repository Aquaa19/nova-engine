# nova-engine/Dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install core runtimes and compilers
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    black \
    python3-autopep8 \
    openjdk-17-jdk \
    gcc \
    g++ \
    bash \
    curl \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install modern Node.js (Node 18 LTS) from official pre-compiled binaries
RUN curl -fsSL https://nodejs.org/dist/v18.20.2/node-v18.20.2-linux-x64.tar.xz | tar -xJ --strip-components=1 -C /usr/local

# Create an unprivileged user for the sandbox
RUN useradd -m -u 1000 -s /bin/bash student

# Setup the default working directory
WORKDIR /workspace

# Pre-install global node modules for offline sandbox support
RUN npm install -g express
ENV NODE_PATH=/usr/local/lib/node_modules

USER student
