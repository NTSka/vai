# Yandex Cloud Deployment

The deployment unit is a container image. GitHub Actions builds the images,
pushes them to Yandex Container Registry, and the Yandex runtime pulls those
images by immutable tag.

## Recommended MVP Topology

- Yandex Container Registry stores application images.
- A Container Optimized Image VM runs Docker Compose for:
  - `backend`: Fastify HTTP API;
  - `web`: SvelteKit Node server;
  - `worker`: background processing loop;
  - `cv-ocr-service`: Python gRPC OCR service.
- Managed PostgreSQL should provide `DATABASE_URL`.
- Yandex Object Storage should provide the S3-compatible bucket variables.

This topology keeps the worker and gRPC service as long-running processes. It
is simpler than splitting the MVP across Serverless Containers before the
runtime boundaries are stable.

## GitHub Secrets

Required for image publishing:

- `YC_SA_JSON_CREDENTIALS`: authorized key JSON for a service account.
- `YC_REGISTRY_ID`: Yandex Container Registry id.

The publishing service account needs permission to push images to the registry.

Required later for VM deployment:

- `YC_FOLDER_ID`
- `YC_SUBNET_ID`
- `YC_VM_SERVICE_ACCOUNT_ID`

Application runtime secrets should be injected through the VM environment,
Lockbox, or the deployment mechanism used to render
`deploy/yandex/docker-compose.coi.yaml`.

## Images

The workflow publishes:

- `cr.yandex/<registry-id>/vai2-backend:<git-sha>`
- `cr.yandex/<registry-id>/vai2-worker:<git-sha>`
- `cr.yandex/<registry-id>/vai2-web:<git-sha>`
- `cr.yandex/<registry-id>/vai2-cv-ocr-service:<git-sha>`

It also pushes the same images with the `latest` tag for manual testing.
Deployments should prefer the immutable Git SHA tag.

## Runtime Environment

Set these values for the COI compose runtime:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE=false`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `AUTH_COOKIE_SECURE=false` when serving the MVP over plain HTTP.
  Use `true` once the public entrypoint is HTTPS.
- `WEB_ORIGIN`, for example `http://<public-ip>` or the HTTPS domain.
- `WEB_BODY_SIZE_LIMIT=Infinity` for direct large-file uploads through
  SvelteKit's Node adapter. Keep backend upload limits as the authoritative
  application limit.

The backend and worker use `cv-ocr-service:50051` inside the compose network.
