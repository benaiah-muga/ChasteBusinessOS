import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const { server } = await buildServer();
await server.listen({ port, host });
server.log.info(`ChasteBusinessOS API listening on http://${host}:${port}`);
