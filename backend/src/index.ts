import fs from 'fs';
import path from 'path';
import cors from 'cors';
import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import logger from 'morgan';
import MongoStore from 'connect-mongo';
import { MongoClient } from 'mongodb';
import env from './environments';
import mountPaymentsEndpoints from './handlers/payments';
import mountUserEndpoints from './handlers/users';

// We must import typedefs for ts-node-dev to pick them up when they change (even though tsc would supposedly
// have no problem here)
// https://stackoverflow.com/questions/65108033/property-user-does-not-exist-on-type-session-partialsessiondata#comment125163548_65381085
import "./types/session";
interface Item {
  name: string;
  image: string;
  price: number;
  rank: number;
  quantity: number;
}

const dbName = env.mongo_db_name;
const mongoUri = `mongodb://${env.mongo_host}/${dbName}`;
const mongoClientOptions = {
  authSource: "admin",
  auth: {
    username: env.mongo_user,
    password: env.mongo_password,
  },
}


//
// I. Initialize and set up the express app and various middlewares and packages:
//

const app: express.Application = express();

// Log requests to the console in a compact format:
app.use(logger('dev'));

// Full log of all requests to /log/access.log:
app.use(logger('common', {
  stream: fs.createWriteStream(path.join(__dirname, '..', 'log', 'access.log'), { flags: 'a' }),
}));

// Enable response bodies to be sent as JSON:
app.use(express.json())

// Handle CORS:
app.use(cors({
  origin: env.frontend_url,
  credentials: true
}));

// Handle cookies 🍪
app.use(cookieParser());

// Use sessions:
app.use(session({
  secret: env.session_secret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: mongoUri,
    mongoOptions: mongoClientOptions,
    dbName: dbName,
    collectionName: 'user_sessions'
  }),
}));


//
// II. Mount app endpoints:
//

// Payments endpoint under /payments:
const paymentsRouter = express.Router();
mountPaymentsEndpoints(paymentsRouter);
app.use('/payments', paymentsRouter);

// User endpoints (e.g signin, signout) under /user:
const userRouter = express.Router();
mountUserEndpoints(userRouter);
app.use('/user', userRouter);

const purchaseRouter = express.Router();

purchaseRouter.post('/', async (req, res) => {
  const { userId, productName, quantity } = req.body;
  try {
    const user = await app.locals.userCollection.findOne({ id: userId });
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    const company = await app.locals.companyCollection.findOne({ "items.name": productName });
    if (!company) {
      return res.status(404).send({ message: "Product not found" });
    }

    const item = company.items.find((item: Item) => item.name === productName);
    if (!item || item.quantity < quantity) {
      return res.status(400).send({ message: "Insufficient item quantity" });
    }

    // Update item quantity
    const newQuantity = item.quantity - quantity;
    await app.locals.companyCollection.updateOne(
      { "company_name": company.company_name, "items.name": productName },
      { $set: { "items.$.quantity": newQuantity } }
    );

    // Create a new order
    await app.locals.orderCollection.insertOne({
      product_name: productName,
      product_company: company.company_name,
      quantity: quantity,
      user_purchased: user.name,
    });

    res.status(201).send({ message: "Purchase successful" });
  } catch (err) {
    console.error("Purchase failed: ", err);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.use('/purchase', purchaseRouter);

// Hello World page to check everything works:
app.get('/', async (_, res) => {
  res.status(200).send({ message: "Hello, World!" });
});





// III. Boot up the app:

app.listen(8000, async () => {
  try {
    const client = await MongoClient.connect(mongoUri, mongoClientOptions)
    const db = client.db(dbName);
    app.locals.orderCollection = db.collection('orders');
    app.locals.userCollection = db.collection('users');
    app.locals.companyCollection = db.collection('companies');
    console.log('Connected to MongoDB on: ', mongoUri)
  } catch (err) {
    console.error('Connection to MongoDB failed: ', err)
  }

  console.log('App platform demo app - Backend listening on port 8000!');
  console.log(`CORS config: configured to respond to a frontend hosted on ${env.frontend_url}`);
});
