import express, { type Request, type Response } from 'express'
import cors from 'cors'
import 'dotenv/config'
const app = express()

app.use(express.json())
app.use(cors())

app.get('/', (req: Request, res: Response) => {
  res.send('Hel World!')
})
app.listen(7000, () => {
  console.log('Server is running on port 7000')
})