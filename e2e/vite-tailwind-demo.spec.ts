import { test, expect } from '@playwright/test';

test.describe('Vite Tailwind Demo', () => {
  test('should load the demo page and start the Tailwind preview', async ({ page }) => {
    await page.goto('/examples/vite-tailwind-demo.html');

    await expect(page.locator('.demo-topbar .title')).toContainText('Vite + Tailwind');
    await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 10000 });
    await expect(page.locator('#editor')).toHaveValue(/Vite \+ Tailwind Demo/);
    await expect(page.locator('.file-tab[data-file="/vite.config.ts"]')).toBeVisible();

    await page.click('#run-btn');
    await expect(page.locator('#status-text')).toContainText('Dev server running', { timeout: 30000 });

    const iframe = page.locator('#preview-frame');
    await expect(iframe).toBeVisible();

    const iframeHandle = await iframe.elementHandle();
    const frame = await iframeHandle?.contentFrame();
    expect(frame).toBeTruthy();

    await expect(frame!.locator('#headline')).toContainText('Vite + Tailwind in the browser', { timeout: 10000 });
  });

  test('should serve Tailwind runtime and strip Tailwind CSS import', async ({ page }) => {
    await page.goto('/examples/vite-tailwind-demo.html');
    await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 10000 });

    await page.click('#run-btn');
    await expect(page.locator('#status-text')).toContainText('Dev server running', { timeout: 30000 });

    const htmlResult = await page.evaluate(async () => {
      const response = await fetch('/__virtual__/3000/?t=' + Date.now());
      const text = await response.text();
      return { ok: response.ok, text };
    });

    expect(htmlResult.ok).toBe(true);
    expect(htmlResult.text).toContain('cdn.tailwindcss.com');
    expect(htmlResult.text).toContain('href="./src/style.css"');

    const cssResult = await page.evaluate(async () => {
      const response = await fetch('/__virtual__/3000/src/style.css?t=' + Date.now());
      const text = await response.text();
      return { ok: response.ok, text };
    });

    expect(cssResult.ok).toBe(true);
    expect(cssResult.text).not.toContain('@import "tailwindcss"');
    expect(cssResult.text).toContain('color-scheme: dark');
  });
});
