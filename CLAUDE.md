# ReCall — Project Context

## What this is
A PWA (Progressive Web App) for semantic search over saved internet content. Users save URLs via a Share Sheet on Android, and search their saves using natural language. Built as a portfolio project for Google APM applications.

## Stack
- Frontend: React + Vite PWA, deployed on Vercel at https://recall-iota-six.vercel.app
- Backend: Python + FastAPI, deployed on Railway at https://recall-production-9941.up.railway.app
- Database: Supabase (Postgres + pgvector for semantic search)
- AI: Gemini API (gemini-embedding-001 for embeddings, gemini-2.5-flash-preview-04-17 for auto-tagging)
- Auth: Supabase Auth with Google OAuth

## Folder structure
- /recall-frontend — React PWA (Vite)
- /recall-backend — FastAPI backend

## Key files
- recall-frontend/src/App.jsx — entire frontend
- recall-backend/main.py — entire backend
- recall-frontend/public/manifest.json — PWA manifest with Share Target config
- recall-frontend/vercel.json — Vercel rewrite rules

## How embeddings work
Text is embedded using gemini-embedding-001 at 768 dimensions via direct REST API call (not the SDK). Stored in Supabase pgvector. Search uses cosine similarity via a match_saves RPC function.

## Important things to know
- The Gemini SDK has issues — embeddings use direct HTTP requests to v1beta REST API
- vercel.json must be in recall-frontend/ folder (root directory is set to recall-frontend in Vercel)
- Row Level Security is enabled on all Supabase tables — users can only see their own saves
- Never commit .env files — they contain Supabase URL, service key, and Gemini API key