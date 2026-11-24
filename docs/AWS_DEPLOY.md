# Deploying CareRelay on AWS

Architecture: **App Runner** (Next.js container + in-process care sweep + `/api/mcp`) → **RDS PostgreSQL 16** (care data, audit log) and **S3** (uploaded documents + cached ElevenLabs handover audio). Secrets live in **Secrets Manager**.

```
Browser / Claude Desktop ──HTTPS──▶ App Runner (CareRelay container)
                                      ├─▶ RDS PostgreSQL 16
                                      ├─▶ S3  (documents/, audio/)
                                      ├─▶ Anthropic API
                                      └─▶ ElevenLabs API
```

## 1. S3 bucket
Console → S3 → Create bucket, e.g. `carerelay-<team>-docs`, same region as everything else. Keep "Block all public access" ON (the app reads/writes through the SDK).

## 2. RDS PostgreSQL
RDS → Create database → PostgreSQL 16, template **Free tier**, `db.t4g.micro`, username `carerelay`, a strong password, initial database name `carerelay`.
Quick hackathon path: **Public access = Yes** and a security group allowing inbound 5432 (tighten later; the production path is an App Runner VPC connector + private RDS).
Connection string: `postgresql://carerelay:<password>@<endpoint>:5432/carerelay`

## 3. Build and push the image to ECR
```bash
aws ecr create-repository --repository-name carerelay --region <region>
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
docker build --platform linux/amd64 -t carerelay .
docker tag carerelay:latest <acct>.dkr.ecr.<region>.amazonaws.com/carerelay:latest
docker push <acct>.dkr.ecr.<region>.amazonaws.com/carerelay:latest
```
(No local Docker? Use AWS CloudShell or a CodeBuild project to run the same commands.)

## 4. IAM instance role (S3 access)
IAM → Roles → Create → trusted entity **App Runner** (`tasks.apprunner.amazonaws.com`), inline policy:
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::carerelay-<team>-docs/*" }] }
```
If you use Secrets Manager references, also allow `secretsmanager:GetSecretValue` on those secrets.

## 5. App Runner service
App Runner → Create service → Container registry → ECR → `carerelay:latest`, port **3000**, 1 vCPU / 2 GB, **min = max = 1 instance** (the scheduler is in-process). Security → instance role from step 4.

Environment variables:
| Name | Value |
|---|---|
| `DATABASE_URL` | RDS string (store in Secrets Manager) |
| `APP_URL` | the App Runner URL, e.g. `https://xxxx.<region>.awsapprunner.com` (set after first deploy, then redeploy) |
| `DEMO_MODE` | `true` for judging |
| `SEED_ON_START` | `true` for the first deploy, then `false` |
| `SCHEDULER_ENABLED` | `true` |
| `STORAGE_PROVIDER` | `s3` |
| `S3_BUCKET` / `AWS_REGION` | your bucket / region |
| `ANTHROPIC_API_KEY` | secret |
| `ELEVENLABS_API_KEY` | secret |

Health check: HTTP path `/login`.

## 6. Verify
- Open the URL, sign in as Priya, header shows "ElevenLabs voice" live badge.
- Handover → **Listen to handover (ElevenLabs)** plays; S3 bucket now has `audio/…mp3`.
- Upload a discharge PDF → object appears under the bucket.
- `curl -X POST $APP_URL/api/mcp -H "Authorization: Bearer crt_demo_priya_0000000000000000000000" …` reaches the MCP server.
