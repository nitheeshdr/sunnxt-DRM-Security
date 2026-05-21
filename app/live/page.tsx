import { getLiveChannels } from "@/lib/api";
import ContentCard from "@/components/ContentCard";
import type { ContentItem } from "@/types";

export const revalidate = 60;

export default async function LivePage() {
  let channels: ContentItem[] = [];
  try {
    const res = await getLiveChannels(60);
    channels = ((res as { results?: ContentItem[] }).results || []) as ContentItem[];
  } catch (err) {
    console.error("Failed to load live channels:", err);
  }

  return (
    <div className="bg-[#0f0f0f] min-h-screen">
      <div className="px-4 sm:px-8 py-6 max-w-350 mx-auto">
        <h1 className="text-xl sm:text-2xl font-bold text-white mb-1 flex items-center gap-2">
          <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse inline-block" />
          Live TV
        </h1>
        <p className="text-gray-400 text-xs sm:text-sm">
          {channels.length > 0 ? `${channels.length} channels streaming now` : "Watch live channels"}
        </p>
      </div>

      {channels.length > 0 ? (
        <div className="px-4 sm:px-8 max-w-350 mx-auto pb-10">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 sm:gap-3">
            {channels.map((channel) => (
              <ContentCard key={channel._id} item={channel} layout="portrait" size="sm" />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-64 text-gray-500">
          No live channels available right now.
        </div>
      )}
    </div>
  );
}
