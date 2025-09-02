import { JSX } from 'react'
import { inferRouterOutputs } from '@trpc/server'
import { AppRouter } from '../trpc'

type RouterOutput = inferRouterOutputs<AppRouter>

type Messages = RouterOutput['getFileMessage']['messages']

type OmitText = Omit<Messages[number], 'text'>

type ExtendedText = {
  text: string | JSX.Element
}

export type ExtendedMessage = OmitText & ExtendedText