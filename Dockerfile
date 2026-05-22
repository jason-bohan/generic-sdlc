FROM node:22-alpine

# curl: health checks; docker-cli + compose + git: sibling container management and remote builds
# libstdc++ + libgcc + icu-libs: required by PowerShell Core (pwsh) on Alpine
RUN apk add --no-cache curl docker-cli docker-cli-compose git libstdc++ libgcc icu-libs

# Install PowerShell Core so test scripts (.ps1) run on Linux too
ARG PS_VERSION=7.4.6
RUN curl -fsSL https://github.com/PowerShell/PowerShell/releases/download/v${PS_VERSION}/powershell-${PS_VERSION}-linux-musl-x64.tar.gz \
      -o /tmp/pwsh.tar.gz \
    && mkdir -p /opt/pwsh \
    && tar -xzf /tmp/pwsh.tar.gz -C /opt/pwsh \
    && chmod +x /opt/pwsh/pwsh \
    && ln -s /opt/pwsh/pwsh /usr/bin/pwsh \
    && rm /tmp/pwsh.tar.gz

# Pin npm to 11.x (avoids 10.x audit noise; update when 12 releases)
RUN npm install -g npm@11.14.1

WORKDIR /app

COPY package*.json ./
# Install all deps (tsx is a devDependency needed to run the server)
RUN npm ci

COPY . .

ENV NODE_ENV=development
EXPOSE 3001

HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
    CMD curl -sf http://localhost:3001/api/status?agentId=frontend || exit 1

CMD ["npm", "run", "server"]
