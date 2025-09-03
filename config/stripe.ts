export const PLANS = [
  {
    name: "Free",
    slug: "free",
    quota: 10,
    pagesPerPdf: 5,
    price: {
      amount: 0.0,
      priceIds: {
        test: process.env.STRIPE_PRICE_ID!,
        production: "",
      },
    },
  },
  {
    name: "Pro",
    slug: "pro",
    quota: 50,
    pagesPerPdf: 25,
    price: {
      amount: 25.0,
      priceIds: {
        test: process.env.STRIPE_PRICE_ID!,
        production: "",
      },
    },
  },
];