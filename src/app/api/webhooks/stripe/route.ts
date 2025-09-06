// @ts-nocheck
import { stripe } from "@/lib/stripe"
import { headers } from "next/headers"
import Stripe from "stripe"
import { db } from "../../../../../db"

export const config = {
  api: {
    bodyParser: false,
  },
};

export async function POST(request: Request) {
  const body = await request.text()
  const signature = (await headers()).get('Stripe-Signature') ?? ''

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    return new Response(
      `Webhook Error: ${
        err instanceof Error ? err.message : 'Unknown Error'
      }`,
      { status: 400 }
    )
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      if (!session?.metadata?.userId) {
        return new Response(null, { status: 200 })
      }

      if (!session.subscription) {
        console.error('No subscription found in checkout session')
        return new Response('No subscription found', { status: 400 })
      }

      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      )

      // console.log('Subscription object:', subscription)
      // console.log('Current period end:', subscription.current_period_end)

      await db.user.update({
        where: {
          id: session.metadata.userId,
        },
        data: {
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: subscription.customer as string,
          stripePriceId: subscription.items.data[0]?.price.id,
          stripeCurrentPeriodEnd: subscription.current_period_end 
            ? new Date(subscription.current_period_end * 1000)
            : new Date(),
        },
      })
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice

      if (!(invoice as any).subscription) {
        console.error('No subscription found in invoice')
        return new Response('No subscription found', { status: 400 })
      }

      // Retrieve the subscription details from Stripe
      const subscription = await stripe.subscriptions.retrieve(
        (invoice as any).subscription as string
      )

      console.log('Invoice subscription object:', subscription)
      console.log('Invoice current period end:', subscription.current_period_end)

      await db.user.update({
        where: {
          stripeSubscriptionId: subscription.id,
        },
        data: {
          stripePriceId: subscription.items.data[0]?.price.id,
          stripeCurrentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : new Date(),
        },
      })
    }

    return new Response(null, { status: 200 })

  } catch (error) {
    console.error('Stripe webhook processing error:', error)
    return new Response(
      `Webhook processing error: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      { status: 500 }
    )
  }
}