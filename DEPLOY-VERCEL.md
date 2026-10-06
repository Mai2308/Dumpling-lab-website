# Vercel + MongoDB Atlas demo deployment

This repository can deploy its static restaurant site and API to Vercel, use MongoDB Atlas for accounts/menu/offers/orders, and use Cloudinary for uploaded menu photos.

> **Demo/testing only on Vercel Hobby.** [Vercel's free Hobby plan](https://vercel.com/docs/plans/hobby) is restricted to personal, non-commercial use. Do not use this deployment to accept live restaurant orders or run a business. Vercel Pro is required for commercial use. Free database/media plans also have quotas and are not a substitute for backups or production support.

This creates a **fresh MongoDB database**. It does not import local SQLite users, menu edits, offers, orders, or photos. On first API access, the API seeds the sample menu and provisions an administrator from environment variables.

## 1. Push the project to GitHub

Push the current project to a GitHub repository. Confirm the repository includes `assets/hero-background.jpeg` and the `api/` folder. Never commit `data/`, `.env.local`, database URIs, admin passwords, JWT secrets, or Cloudinary secrets.

## 2. Create a MongoDB Atlas free cluster

1. Create a MongoDB Atlas account and a project, then create an Atlas Free cluster.
2. Create a database user with a strong, unique password. This is different from the Atlas website login.
3. Configure Network Access. Vercel's default function egress uses dynamic IPs, so a fixed-IP allowlist is not generally available on the free setup. For a demo, Atlas may need `0.0.0.0/0`; enable database authentication, use a database user limited to this project's database, and never expose the URI in client-side code. If your Vercel/Atlas integration provides a supported private or managed connection, prefer it.
4. Copy the Atlas driver connection string. Replace its username/password placeholders; URL-encode reserved characters in the database password. The app defaults to the `dumpling_lab` database, which can be overridden with `MONGODB_DB`.

Atlas Free clusters are intended for small-scale learning and development; review [current Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) before using one.

## 3. Create a Cloudinary account

The app sends admin-authorized uploads through its API to Cloudinary. In the Cloudinary dashboard, copy the **cloud name**, **API key**, and **API secret**. Only the server function receives these credentials; do not use an unsigned upload preset or put the API secret in the browser.

## 4. Import the project into Vercel

1. Sign in to Vercel and import the GitHub repository.
2. Keep the repository root as the project root. The checked-in `vercel.json` disables framework autodetection, runs the explicit build command, and sets `public/` as the static output. The build copies only frontend files into `public/`; it does not publish `server.mjs` or project secrets.
3. `api/[...path].mjs` is deployed as a Node.js Function for `/api/*`. The original `server.mjs` continues to power local SQLite development only.
4. Add these environment variables in the Vercel project settings for **Preview** and **Development**. Add them for **Production** only if using a plan permitted for the intended use:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | The private Atlas driver connection string |
| `MONGODB_DB` | `dumpling_lab` |
| `JWT_SECRET` | At least 32 random characters |
| `BOOTSTRAP_ADMIN_EMAIL` | Your admin email |
| `BOOTSTRAP_ADMIN_PASSWORD` | A unique password with 12–128 characters |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

Generate a JWT secret locally with PowerShell:

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Generate a safe random admin password locally with:

```powershell
([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
```

Paste the generated values directly into Vercel's encrypted environment-variable settings. Do not commit them. Never print or share the MongoDB URI, Cloudinary secret, admin password, or JWT secret.

5. Deploy. Vercel provides a preview URL. Test customer signup/login, admin login, menu display, and a test order with non-real details. Verify admin menu edits and photo uploads; uploaded image URLs should use Cloudinary.
6. Remember: **Hobby is for non-commercial demos only.** Do not publish this preview as the live business storefront or collect real customer order/contact information under that plan.

## Troubleshooting Vercel's `FUNCTION_INVOCATION_FAILED`

If the homepage, CSS, image, and API all show the Vercel function error, redeploy the latest commit with the repository's `vercel.json` and `scripts/prepare-vercel.mjs`. This build explicitly separates static website files into `public/` from the API function; it prevents Vercel from treating the local SQLite server as the handler for every URL.

If only `/api/*` requests fail after redeploying, open **Vercel Dashboard → Project → Logs → Functions**, filter to the failed request, and check the error. Common configuration issues are missing `MONGODB_URI` or a `JWT_SECRET` shorter than 32 characters. For an Atlas network error, verify the database user, connection string, and Atlas Network Access allowlist. Never paste credentials into an issue or chat.

## Admin account behavior

The API creates the administrator on the first API request if the configured email is not already in the database. If the email already belongs to a customer, initialization fails safely; choose another admin email. Once created, changing `BOOTSTRAP_ADMIN_PASSWORD` does not change that account's password.

Customer signup is public and always creates the `customer` role. Admin-only routes check the current role in MongoDB as well as the signed JWT, so a customer cannot use menu, offer, order-management, or photo-upload write operations.

## Local development

The existing `npm start` command remains the original SQLite local server and does not use the new Vercel/MongoDB API. To exercise the Vercel function locally, install/use the Vercel CLI and run `vercel dev` after creating an ignored `.env.local` with the environment variables above. Never commit `.env.local`.

The Atlas Free cluster is shared, remote storage and should be treated as a demo database. Keep private backups of any data you care about. Vercel Hobby deployments can be paused or limited when usage quotas are reached.
