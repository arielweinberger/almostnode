import { test, expect, Frame, Page } from '@playwright/test';

async function startPreview(page: Page): Promise<Frame> {
  await page.goto('/examples/next-tailwind-demo.html');

  await expect(page.locator('.demo-topbar .title')).toContainText('Next + Tailwind v4');
  await expect(page.locator('#status-text')).toContainText('Ready', { timeout: 10000 });
  await expect(page.locator('#editor')).toHaveValue(/Next \+ Tailwind v4/);

  await page.click('#run-btn');
  await expect(page.locator('#status-text')).toContainText('Dev server running', { timeout: 120000 });

  const iframe = page.locator('#preview-frame');
  await expect(iframe).toBeVisible();

  const iframeHandle = await iframe.elementHandle();
  const frame = await iframeHandle?.contentFrame();
  if (!frame) {
    throw new Error('Could not access preview iframe');
  }

  await expect(frame.locator('#brand-card')).toBeVisible({ timeout: 60000 });
  return frame;
}

async function backgroundColor(frame: Frame, selector: string): Promise<string> {
  return frame.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
}

test.describe('Next Tailwind v4 Demo', () => {
  test('should serve compiled Tailwind v4 CSS without CDN injection', async ({ page }) => {
    const frame = await startPreview(page);

    await expect.poll(
      () => backgroundColor(frame, '#brand-card'),
      { timeout: 30000 }
    ).not.toBe('rgba(0, 0, 0, 0)');

    const htmlResult = await page.evaluate(async () => {
      const response = await fetch('/__virtual__/3002/?t=' + Date.now());
      const text = await response.text();
      return { ok: response.ok, text };
    });

    expect(htmlResult.ok).toBe(true);
    expect(htmlResult.text).not.toContain('cdn.tailwindcss.com');
    expect(htmlResult.text).toContain('/__virtual__/3002/app/globals.css');

    const cssResult = await page.evaluate(async () => {
      const response = await fetch('/__virtual__/3002/app/globals.css?t=' + Date.now());
      const text = await response.text();
      return { ok: response.ok, text };
    });

    expect(cssResult.ok).toBe(true);
    expect(cssResult.text).toContain('tailwindcss v4');
    expect(cssResult.text).not.toContain('@import "tailwindcss"');
    expect(cssResult.text).toContain('.bg-brand-500');
    expect(cssResult.text).toContain('.bg-sky-500');
  });

  test('should live update Tailwind output when source classes and CSS tokens change', async ({ page }) => {
    const frame = await startPreview(page);
    const initialBrandColor = await backgroundColor(frame, '#brand-card');
    const initialUtilityColor = await backgroundColor(frame, '#utility-card');

    await page.click('.file-tab[data-file="/app/globals.css"]');
    const cssEditor = page.locator('#editor');
    const css = await cssEditor.inputValue();
    await cssEditor.fill(css.replace('oklch(0.72 0.18 150)', 'oklch(0.68 0.2 30)'));
    await page.click('#save-btn');

    await expect.poll(
      () => backgroundColor(frame, '#brand-card'),
      { timeout: 30000 }
    ).not.toBe(initialBrandColor);

    await page.click('.file-tab[data-file="/app/page.jsx"]');
    const pageEditor = page.locator('#editor');
    const pageCode = await pageEditor.inputValue();
    await pageEditor.fill(pageCode.replace('bg-sky-500', 'bg-fuchsia-500'));
    await page.click('#save-btn');

    await expect.poll(
      () => backgroundColor(frame, '#utility-card'),
      { timeout: 30000 }
    ).not.toBe(initialUtilityColor);
  });
});
