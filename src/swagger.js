const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Firmware Dashboard API',
      version: '1.0.0',
      description: 'BMC Firmware 輪詢與歷史紀錄查詢 API'
    }
  },
  apis: [__filename.replace('swagger.js', 'index.js')]
};

module.exports = swaggerJsdoc(options);
