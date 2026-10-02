import "dotenv/config";
import { createApp } from "./app.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\nANTHROPIC_API_KEY is not set.\nCopy .env.example to .env and add your key, then run `npm run dev` again.\n",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});
