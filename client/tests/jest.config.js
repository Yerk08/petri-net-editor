const path = require('path');

module.exports = {
  testEnvironment: "jsdom",
  
  // 1. Корень для этой конфигурации — сама папка tests/
  rootDir: __dirname, 
  
  // 2. КРИТИЧЕСКИЙ ШАГ: Говорим искать исходники во всей папке client/ по абсолютному пути
  roots: [
    path.resolve(__dirname, '../modules'),
    path.resolve(__dirname, './')
  ],
  
  setupFilesAfterEnv: [path.resolve(__dirname, "setupTests.js")],
  testMatch: [path.resolve(__dirname, "**/*.test.js")],
  
  transform: {
    "^.+\\.jsx?$": [
      "babel-jest", 
      { "configFile": path.resolve(__dirname, "babel.config.json") }
    ]
  },

  // 3. Явно включаем сбор покрытия
  collectCoverage: true,
  // Передаем жесткий глобальный паттерн для папки модулей снаружи
  collectCoverageFrom: [
    "../modules/**/*.js",
    "!**/node_modules/**"
  ],
  
  coverageDirectory: path.resolve(__dirname, "coverage"),
  
  // 4. Заставляем Jest принудительно сканировать файлы вне текущей папки tests/
  transformIgnorePatterns: [
    "/node_modules/"
  ]
};
