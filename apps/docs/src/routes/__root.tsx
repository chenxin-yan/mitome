import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { appName } from "@/lib/shared";
import appCss from "@/styles/app.css?url";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- HTML's meta charset is spelled utf-8
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: appName,
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
