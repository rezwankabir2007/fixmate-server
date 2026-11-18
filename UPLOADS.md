# FixMate — Profile Image Uploads

Profile photos are uploaded through the backend and stored in Cloudinary.
The browser never talks to Cloudinary directly and never sees the API secret.

## Required backend environment variables

Set these in `fixmate-server/.env` for local development, **and configure the
same three variables in the environment settings of your deployed backend**
(e.g. Render, Railway, Vercel backend, Heroku, VPS `.env`):

```
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

Rules:

- These are **backend-only** variables. Never put them in `NEXT_PUBLIC_*`
  variables and never import them in `fixmate-client` code.
- `.env` files are ignored by Git in both repos (`fixmate-server/.gitignore`,
  `fixmate-client/.gitignore`). Keep it that way.
- The secret is used only by `fixmate-server/config/cloudinary.js` to sign
  uploads server-side (official Cloudinary SDK, `upload_stream`).

## Endpoint

```
POST /api/upload/profile-image
```

| Item        | Value                                             |
| ----------- | ------------------------------------------------- |
| Content-Type| `multipart/form-data`                             |
| Field name  | `image` (single file)                             |
| Max size    | 2 MB                                              |
| Types       | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| Auth        | Not required (users upload before signup)         |
| Protection  | Same-origin check (`Origin` header must match host) |
| Folder      | `fixmate/profiles` (Cloudinary)                   |

Success response:

```json
{
  "success": true,
  "secure_url": "https://res.cloudinary.com/<cloud>/image/upload/v1234567890/fixmate/profiles/xxxx.jpg"
}
```

Error responses are JSON: `{ "error": "<safe message>" }` with status
`400` (missing/invalid request), `403` (different origin), `413` (larger than
2 MB), `415` (unsupported image type) or `502` (Cloudinary upload failed).

## Testing with Postman

1. Start the backend: `npm run dev` inside `fixmate-server` (port 5000).
2. Create request → **POST** → `http://localhost:5000/api/upload/profile-image`.
3. **Headers** tab → add `Origin` → `http://localhost:5000`
   (the endpoint enforces same-origin; without this header Postman gets 403).
4. **Body** tab → select **form-data**.
5. In the key column type `image`, then change the key's type from *Text* to
   **File** (use the dropdown that appears when you hover the key).
6. Select a valid JPG/PNG/WEBP/GIF image (under 2 MB) as the value.
7. Send. Expect `200` with `success: true` and a `secure_url` beginning with
   `https://res.cloudinary.com/...`.

Negative tests:

- Send without the `image` field → `400`.
- Send a `.txt` file → `415`.
- Send an image larger than 2 MB → `413`.
- Remove the `Origin` header → `403`.

You can also test through the Next.js proxy (frontend running on port 3000):
POST to `http://localhost:3000/api/upload/profile-image` with header
`Origin: http://localhost:3000`.

## Testing signup

- **Without an image:** fill the sign-up form and submit. No upload request is
  made and signup behaves exactly as before (no `image` field is sent).
- **With an image:** select a photo, submit. The browser first POSTs the file
  to `/api/upload/profile-image`, then calls Better Auth
  `signUp.email()` with only the returned `secure_url` as `image`. If the
  upload fails, a toast is shown and signup does **not** proceed.
- Verify the created user's `image` field in the `users` collection contains a
  Cloudinary URL, not a Base64 string.
