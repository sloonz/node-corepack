ARG NODE_IMAGE=node:26-alpine
FROM ${NODE_IMAGE}

# The synchronizer resolves latest once per run and supplies an exact version.
ARG COREPACK_VERSION=latest
RUN npm install --global "corepack@${COREPACK_VERSION}" \
    && corepack enable \
    && npm cache clean --force
