import { once } from "node:events";
import { connect } from "node:tls";
import type { SmtpConnector } from "../server/smtp-email-delivery";

/** The existing SMTP workflow keeps its deadlines, validation and retries; only the TLS socket changes. */
export const vpsSmtpConnector: SmtpConnector = (address) => {
  const socket = connect({ host: address.hostname, port: address.port, servername: address.hostname });
  const opened = once(socket, "secureConnect");
  const iterator = socket[Symbol.asyncIterator]();
  return {
    opened,
    readable: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      },
      cancel() {
        socket.destroy();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        await opened;
        await new Promise<void>((resolve, reject) =>
          socket.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve())),
        );
      },
      close() {
        socket.end();
      },
      abort() {
        socket.destroy();
      },
    }),
    close() {
      socket.destroy();
    },
  };
};
