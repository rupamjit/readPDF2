import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { db } from "../../../../db";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { PineconeStore } from "@langchain/pinecone";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { Pinecone } from "@pinecone-database/pinecone";
import { UploadThingError } from "uploadthing/server";
import { getUserSubscriptionPlan } from "@/lib/stripe";
import { PLANS } from "../../../../config/stripe";

const f = createUploadthing();

const middleware = async () => {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || !user.id) throw new UploadThingError("Unauthorized.");

  const subscriptionPlan = await getUserSubscriptionPlan();

  return { subscriptionPlan, userId: user.id };
};

const onUploadComplete = async ({
  metadata,
  file,
}: {
  metadata: Awaited<ReturnType<typeof middleware>>;
  file: {
    key: string;
    name: string;
    url: string;
  };
}) => {
  const isFileExist = await db.file.findFirst({
    where: {
      key: file.key,
      userId: metadata.userId,
    },
  });

  if (isFileExist) return;

  const createFile = await db.file.create({
    data: {
      key: file.key,
      name: file.name,
      userId: metadata.userId,
      url: `https://utfs.io/f/${file.key}`,
      uploadStatus: "PROCESSING",
    },
  });

  try {
    const response = await fetch(createFile.url);

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Validate file content
    if (uint8Array.length === 0) {
      throw new Error("Downloaded file is empty");
    }

    // Load PDF using Uint8Array
    const loader = new PDFLoader(
      new Blob([uint8Array], { type: "application/pdf" })
    );

    // Extract PDF page level text
    const pageLevelDocs = await loader.load();
    const pagesAmt = pageLevelDocs.length;

    const { subscriptionPlan } = metadata;
    const { isSubscribed } = subscriptionPlan;

    const isProExceeded =
      pagesAmt > PLANS.find((plan) => plan.name === "Pro")!.pagesPerPdf;
    const isFreeExceeded =
      pagesAmt > PLANS.find((plan) => plan.name === "Free")!.pagesPerPdf;

    if ((isSubscribed && isProExceeded) || (!isSubscribed && isFreeExceeded)) {
      await db.file.update({
        data: {
          uploadStatus: "FAILED",
        },
        where: {
          id: createFile.id,
        },
      });
    }

    // Validate that documents have content
    const hasContent = pageLevelDocs.some(
      (doc) => doc.pageContent.trim().length > 0
    );
    if (!hasContent) {
      throw new Error("PDF contains no readable text content");
    }

    // Initialize Pinecone client
    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!,
    });
    const pineconeIndex = pinecone.Index("readpdf2");

    // Initialize embeddings
    const embeddings = new HuggingFaceInferenceEmbeddings({
      apiKey: process.env.HUGGINGFACE_API_KEY!,
      model: "Qwen/Qwen3-Embedding-8B", // Updated to a more reliable model
    });

    // Store documents in Pinecone
    await PineconeStore.fromDocuments(pageLevelDocs, embeddings, {
      pineconeIndex,
      namespace: createFile.id,
    });

    // Update file status to success
    await db.file.update({
      data: {
        uploadStatus: "SUCCESS",
      },
      where: {
        id: createFile.id,
      },
    });

    console.log(`Successfully processed file: ${file.name}`);
  } catch (error) {
    console.error(`Error processing file ${file.name}:`, error);

    await db.file.update({
      data: {
        uploadStatus: "FAILED",
      },
      where: {
        id: createFile.id,
        userId: metadata.userId,
      },
    });

    // Re-throw the error so UploadThing knows the upload failed
    throw error;
  }
};

export const ourFileRouter = {
  freePlanUploader: f({ pdf: { maxFileSize: "4MB" } })
    .middleware(middleware)
    .onUploadComplete(onUploadComplete),
  proPlanUploader: f({ pdf: { maxFileSize: "16MB" } })
    .middleware(middleware)
    .onUploadComplete(onUploadComplete),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
