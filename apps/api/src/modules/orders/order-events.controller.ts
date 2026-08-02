import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { OrderEventsService } from "./order-events.service.js";

/**
 * Proxies and load balancers close idle connections. A comment line every 25s
 * keeps the stream open without being an event the client has to understand.
 */
const HEARTBEAT_MS = 25_000;

@Controller({ path: "stores/:storeId", version: "1" })
export class OrderEventsController {
  constructor(private readonly events: OrderEventsService) {}

  /**
   * Live order activity for one store (plan §10.4).
   *
   * Gated by the same `orders:read` permission as the queue itself, so the
   * stream cannot become a way to watch a store you may not look at. The
   * events carry no order contents — just enough for the client to know
   * something changed and re-read the queue, which keeps the database the
   * single authority on what staff actually see.
   */
  @Get("events")
  @RequirePermission("orders:read")
  stream(@Param("storeId") storeId: string, @Req() req: Request, @Res() res: Response): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which holds events until
      // the buffer fills — the stream appears to work and arrives in bursts.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const lastEventId = Number(req.header("last-event-id"));
    const afterId = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : undefined;

    // Sent immediately so the client can distinguish "connected" from
    // "connecting" — an EventSource that never fires looks identical to a
    // stream that has simply been quiet.
    res.write(`event: ready\ndata: {"storeId":"${storeId}"}\n\n`);

    const unsubscribe = this.events.subscribe(
      storeId,
      (event) => {
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      afterId,
    );

    // Both a comment and a real event, deliberately.
    //
    // The comment keeps proxies from closing an idle connection. The named
    // event is what the *client* can actually observe: EventSource never
    // surfaces comment lines to JavaScript, so a stream that silently stopped
    // delivering would be indistinguishable from a quiet shop — the browser
    // reports a healthy connection while the queue goes stale. A heartbeat the
    // client can hear is what lets it notice.
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
      res.write(`event: heartbeat\ndata: {"at":"${new Date().toISOString()}"}\n\n`);
    }, HEARTBEAT_MS);

    // Both matter: `close` fires when the client goes away, `error` when the
    // socket breaks. Missing either leaks a listener and an interval per
    // connection, which on a shop tablet reconnecting all day is a real leak.
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
  }
}
