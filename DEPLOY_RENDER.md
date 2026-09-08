# Memento - Render deployment

## What is already prepared
- Node.js / Express server
- PostgreSQL via `DATABASE_URL`
- Products, brands, users, and orders stored in PostgreSQL
- Uploaded images are stored as data URLs in PostgreSQL, so they do not depend on Render's temporary disk
- `render.yaml` is included for a Render Web Service
- `.env` is intentionally NOT included

## Required environment variables on Render
- `DATABASE_URL`: your PostgreSQL connection string
- `ADMIN_PASSWORD`: a strong admin password
- `JWT_SECRET`: a long random secret

## Deploy
1. Push this project to GitHub.
2. In Render choose New > Web Service and select the GitHub repository.
3. Render can use `render.yaml`, or enter:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the three environment variables above.
5. Deploy.

## Important
The application creates its PostgreSQL tables automatically on first startup.
Do not commit `.env` or database credentials.
