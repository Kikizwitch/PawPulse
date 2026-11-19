// 測試設定：測 server 程式碼同前端純函數（src/utils），唔載入 vite.config.ts 嘅 React / Tailwind plugin
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/utils/**/*.test.ts'],
  },
});
