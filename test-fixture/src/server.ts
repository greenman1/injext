import express from 'express';

const app = express();

// Global middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Existing routes
app.use('/health', (req, res) => res.json({ status: 'ok' }));

// Error handler — should always be LAST
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message });
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
