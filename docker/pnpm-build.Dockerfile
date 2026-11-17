FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

USER root

RUN npm install \
      --prefix /opt/deployme-tools \
      --no-save \
      --package-lock=false \
      --include=optional \
      --no-audit \
      --no-fund \
      --registry=https://registry.npmjs.org \
      pnpm@12.18.0 \
    && npm cache clean --force

ENV PATH="/opt/deployme-tools/node_modules/.bin:${PATH}"
ENV COREPACK_ENABLE_NETWORK=0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV HOME=/tmp
ENV CI=true

WORKDIR /tmp
USER 1000:1000

RUN node -e 'const {execFileSync}=require("node:child_process"); const version=execFileSync("/opt/deployme-tools/node_modules/.bin/pnpm",["--version"],{encoding:"utf8"}).trim(); if(version!=="12.18.0") throw new Error("Unexpected pnpm version: "+version); console.log("Verified pnpm "+version);'