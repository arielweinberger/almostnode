import { test, expect } from '@playwright/test';

test.describe('Vite HTML Demo', () => {
  test('should load the demo page and start the preview', async ({ page }) => {
    await page.goto('/examples/vite-html-demo.html');

    await expect(page.locator('.demo-topbar .title')).toContainText('Vite HTML');
    await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 10000 });
    await expect(page.locator('#editor')).toHaveValue(/Hello from index\.html/);

    await page.click('#run-btn');
    await expect(page.locator('#status-text')).toContainText('Dev server running', { timeout: 30000 });

    const iframe = page.locator('#preview-frame');
    await expect(iframe).toBeVisible();

    const iframeHandle = await iframe.elementHandle();
    const frame = await iframeHandle?.contentFrame();
    expect(frame).toBeTruthy();

    await expect(frame!.locator('#headline')).toContainText('Hello from index.html', { timeout: 10000 });
  });

  test('should serve updated index.html after saving', async ({ page }) => {
    await page.goto('/examples/vite-html-demo.html');
    await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 10000 });

    await page.click('#run-btn');
    await expect(page.locator('#status-text')).toContainText('Dev server running', { timeout: 30000 });

    const editor = page.locator('#editor');
    const originalContent = await editor.inputValue();
    const updatedContent = originalContent.replace(
      'Hello from index.html',
      'Root HTML live reload works'
    );

    await editor.fill(updatedContent);
    await page.click('#save-btn');

    await expect(page.locator('#output')).toContainText('full-reload: /index.html', { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const response = await fetch('/__virtual__/3000/?t=' + Date.now());
      const text = await response.text();
      return {
        ok: response.ok,
        text,
      };
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Root HTML live reload works');
  });
});
