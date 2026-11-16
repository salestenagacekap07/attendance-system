FROM node:20-slim

# Some transitive npm dependencies fetch GitHub repos over SSH; the slim
# Node image does not include the CA bundle needed for HTTPS verification, and
# it does not have the SSH client or keys needed for GitHub SSH. Rewrite
# GitHub SSH URLs to HTTPS and install the required clients and certs.
RUN apt-get update && apt-get install -y --no-install-recommends         ca-certificates git openssh-client     && rm -rf /var/lib/apt/lists/*     && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"     && git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
