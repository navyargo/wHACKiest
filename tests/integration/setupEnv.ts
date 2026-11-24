// Integration tests always run against TEST_DATABASE_URL (never the dev database).
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DEMO_MODE = "true";
process.env.ANTHROPIC_API_KEY = "";
process.env.ELEVENLABS_API_KEY = "";
