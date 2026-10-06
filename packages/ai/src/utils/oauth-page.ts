import { PADMA_LOGO_DATA_URI } from "./padma-logo-data-uri.ts";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Padma · ${title}</title>
  <link rel="icon" href="${PADMA_LOGO_DATA_URI}" />
  <style>
    :root {
      --text: #4A342A;
      --text-dim: #7D5A44;
      --page-bg: #faf4ed;
      --card-bg: #F5F1EA;
      --card-border: #D7C9B8;
      --accent: #B2967D;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 44px 36px;
      box-shadow: 0 10px 30px rgba(74, 52, 42, 0.08);
    }
    .logo {
      width: 88px;
      height: 88px;
      display: block;
      margin-bottom: 24px;
      object-fit: contain;
      filter: drop-shadow(0 4px 12px rgba(74, 52, 42, 0.15));
    }
    h1 {
      margin: 0 0 12px;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 700;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 18px;
      padding: 12px 16px;
      background: rgba(178, 150, 125, 0.12);
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="${PADMA_LOGO_DATA_URI}" alt="Padma" />
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Praveśa [Authentication successful]",
		heading: "Praveśa [Authentication successful]",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Praveśa-viphala [Authentication failed]",
		heading: "Praveśa-viphala [Authentication failed]",
		message,
		details,
	});
}
