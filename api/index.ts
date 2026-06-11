import { handle } from "hono/vercel";
import app from "../src/index.js";

/** Vercel entry — vercel.json rewrites all routes to this function. */
export default handle(app);
