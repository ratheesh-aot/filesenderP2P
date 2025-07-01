// HTTP server to serve static files
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, MIME_TYPES } = require('./config');

/**
 * Create and configure the HTTP server
 * @returns {http.Server} - Configured HTTP server instance
 */
function createServer() {
    const server = http.createServer((req, res) => {
        // Handle the request
        let url = req.url;
        
        // Fix for paths that should be query parameters
        if (url.startsWith('/host=')) {
            url = '/?' + url.substring(1);
        }
        
        // Extract the path part from the URL (ignore query parameters)
        const urlPath = url.split('?')[0];
        
        let filePath = path.join(__dirname, '..', 'public', urlPath === '/' ? 'index.html' : urlPath);
        
        // Get the file extension
        const extname = path.extname(filePath);
        
        // Default content type
        let contentType = MIME_TYPES[extname] || 'application/octet-stream';
        
        // Read the file
        fs.readFile(filePath, (err, content) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    // Page not found
                    fs.readFile(path.join(__dirname, '..', 'public', '404.html'), (err, content) => {
                        if (err) {
                            // If 404 page doesn't exist, send simple message
                            res.writeHead(404);
                            res.end('404 Not Found');
                        } else {
                            res.writeHead(404, { 'Content-Type': 'text/html' });
                            res.end(content, 'utf8');
                        }
                    });
                } else {
                    // Server error
                    res.writeHead(500);
                    res.end(`Server Error: ${err.code}`);
                }
            } else {
                // Success
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf8');
            }
        });
    });

    return server;
}

module.exports = {
    createServer
};
