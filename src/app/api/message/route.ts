import { sendMessageValidator } from "@/lib/sendMessageValidator";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { NextRequest } from "next/server";
import { db } from "../../../../db";
import { getPineconeClient } from "@/lib/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json();

    const { getUser } = getKindeServerSession();
    const user = await getUser();

    if (!user || !user.id) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { id: userId } = user;

    const { fileId, message } = sendMessageValidator.parse(body);

    const file = await db.file.findFirst({
      where: {
        id: fileId,
        userId,
      }
    });

    if (!file) {
      return new Response('Not found', { status: 404 });
    }

    // Create user message
    await db.message.create({
      data: {
        text: message,
        isUserMessage: true,
        userId,
        fileId
      }
    });

    // Initialize embeddings
    const embeddings = new HuggingFaceInferenceEmbeddings({
      apiKey: process.env.HUGGINGFACE_API_KEY!,
      model: "Qwen/Qwen3-Embedding-8B",
    });

    // Get Pinecone
    const pinecone = await getPineconeClient();
    const pineconeIndex = pinecone.Index('readpdf2');

    // Create vector store
    const vectorStore = await PineconeStore.fromExistingIndex(
      embeddings,
      {
        pineconeIndex,
        namespace: file.id,
      }
    );

    // Perform similarity search
    const results = await vectorStore.similaritySearch(
      message,
      4
    );

    // Get previous messages
    const prevMessages = await db.message.findMany({
      where: {
        fileId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: 6,
    });

    const formattedPrevMessages = prevMessages.map((msg) => ({
      role: msg.isUserMessage
        ? ('user' as const)
        : ('assistant' as const),
      content: msg.text,
    }));

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
      },
    });

    const prompt = `Use the following pieces of context (or previous conversation if needed) to answer the user's question in markdown format.
If you don't know the answer, just say that you don't know, don't try to make up an answer.

----------------

PREVIOUS CONVERSATION:
${formattedPrevMessages.map((message) => {
  if (message.role === 'user')
    return `User: ${message.content}\n`
  return `Assistant: ${message.content}\n`
}).join('')}

----------------

CONTEXT:
${results.map((r) => r.pageContent).join('\n\n')}

USER INPUT: ${message}`;

    // Generate response
    const response = await model.generateContentStream(prompt);

    // Create ReadableStream
    const stream = new ReadableStream({
      async start(controller) {
        let fullCompletion = '';
        
        try {
          for await (const chunk of response.stream) {
            const text = chunk.text();
            if (text) {
              fullCompletion += text;
              controller.enqueue(new TextEncoder().encode(text));
            }
          }
          
          // Save AI response to database
          if (fullCompletion.trim()) {
            await db.message.create({
              data: {
                text: fullCompletion,
                isUserMessage: false,
                fileId,
                userId,
              },
            });
          }
          
          controller.close();
        } catch (streamError) {
          console.error('Stream error:', streamError);
          controller.error(streamError);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });

  } catch (error) {
    console.error('Message API Error:', error);
    
    // Return a more specific error message
    if (error instanceof Error) {
      return new Response(`Server Error: ${error.message}`, { status: 500 });
    }
    
    return new Response('Internal Server Error', { status: 500 });
  }
};