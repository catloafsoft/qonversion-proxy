import { handleProxyRequest } from "./proxy";

const worker: ExportedHandler<Env> = {
  fetch(request, env) {
    return handleProxyRequest(request, env);
  },
};

export default worker;
