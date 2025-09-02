"use client"
import React, {
  createContext,
  ReactNode,
  useRef,
  useState,
} from "react";
import { trpc } from "@/app/_trpc/client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

interface StreamResponse {
  addMessage: () => void;
  message: string;
  handleInputChange: (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => void;
  isLoading: boolean;
}

export const ChatContext = createContext<StreamResponse>({
  addMessage: () => {},
  message: "",
  handleInputChange: () => {},
  isLoading: false,
});

interface Props {
  fileId: string;
  children: ReactNode;
}

export const INFINITE_QUERY_LIMIT = 10;

export const ChatContextProvider = ({ fileId, children }: Props) => {
    console.log("ChatContextProvider",fileId)
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");

  const utils = trpc.useContext();
  const backupMessage = useRef("");

  const { mutate: sendMessage } = useMutation({
    mutationFn: async ({ message }: { message: string }) => {
      const response = await fetch("/api/message", {
        method: "POST",
        body: JSON.stringify({ fileId, message }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      return response.body;
    },
    onMutate: async ({ message }) => {
      backupMessage.current = message;
      setMessage("");

      // cancel ongoing queries
      await utils.getFileMessage.cancel({ fileId, limit: INFINITE_QUERY_LIMIT });

      // get current data
      const previousMessages = utils.getFileMessage.getInfiniteData({ fileId, limit: INFINITE_QUERY_LIMIT });

      // optimistic update
      utils.getFileMessage.setInfiniteData(
        { fileId, limit: INFINITE_QUERY_LIMIT },
        (old) => {
          if (!old) {
            return { pages: [], pageParams: [] };
          }

          const newPages = [...old.pages];
          const latestPage = newPages[0]!;

          latestPage.messages = [
            {
              createdAt: new Date().toISOString(),
              id: crypto.randomUUID(),
              text: message,
              isUserMessage: true,
            },
            ...latestPage.messages,
          ];

          newPages[0] = latestPage;

          return { ...old, pages: newPages };
        }
      );

      setIsLoading(true);

      return {
        previousMessages:
          previousMessages?.pages.flatMap((page) => page.messages) ?? [],
      };
    },
    onSuccess: async (stream) => {
      setIsLoading(false);

      if (!stream) {
        return toast.error("There was a problem sending this message. Please refresh this page and try again.");
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accResponse = "";

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const chunkValue = decoder.decode(value);

        accResponse += chunkValue;

        utils.getFileMessage.setInfiniteData(
          { fileId, limit: INFINITE_QUERY_LIMIT },
          (old) => {
            if (!old) return { pages: [], pageParams: [] };

            const isAiResponseCreated = old.pages.some((page) =>
              page.messages.some((msg) => msg.id === "ai-response")
            );

            const updatedPages = old.pages.map((page) => {
              if (page === old.pages[0]) {
                let updatedMessages;

                if (!isAiResponseCreated) {
                  updatedMessages = [
                    {
                      createdAt: new Date().toISOString(),
                      id: "ai-response",
                      text: accResponse,
                      isUserMessage: false,
                    },
                    ...page.messages,
                  ];
                } else {
                  updatedMessages = page.messages.map((msg) =>
                    msg.id === "ai-response"
                      ? { ...msg, text: accResponse }
                      : msg
                  );
                }

                return { ...page, messages: updatedMessages };
              }
              return page;
            });

            return { ...old, pages: updatedPages };
          }
        );
      }
    },
    onError: (_, __, context) => {
      setMessage(backupMessage.current);

      // revert back to previous messages on error
      utils.getFileMessage.setInfiniteData(
        { fileId, limit: INFINITE_QUERY_LIMIT },
        (old) => {
          return {
            pages: [{ messages: context?.previousMessages ?? [] }],
            pageParams: [],
          };
        }
      );
    },
    onSettled: async () => {
      setIsLoading(false);
      await utils.getFileMessage.invalidate({ fileId, limit: INFINITE_QUERY_LIMIT });
    },
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
  };

  const addMessage = () => sendMessage({ message });

  return (
    <ChatContext.Provider
      value={{
        addMessage,
        message,
        handleInputChange,
        isLoading,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};
