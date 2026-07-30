import { buildServer } from "./server.js";

const { server, app } = await buildServer();
await server.listen({ port: app.config.port, host: app.config.host });
server.log.info(
  {
    port: app.config.port,
    region: app.config.region,
    aiProvider: app.provider.id,
    org: app.sessionUser.orgName,
  },
  "ChasteBusinessOS API ready",
);
