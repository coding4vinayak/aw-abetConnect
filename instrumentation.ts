/**
 * Sentry instrumentation for abetConnect - runs once per server boot
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.addEventProcessor((event) => {
      if (event.tags) {
        event.tags.product = "abetConnect";
      } else {
        event.tags = { product: "abetConnect" };
      }
      return event;
    });
    console.log("[Sentry] abetConnect server instrumentation registered");
  }
}
