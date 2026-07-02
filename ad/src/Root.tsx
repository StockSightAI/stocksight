import "./index.css";
import { Composition } from "remotion";
import { StockSightAd } from "./Composition";
import { InvestorProfileAd } from "./InvestorProfileAd";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="StockSightAd"
        component={StockSightAd}
        durationInFrames={630}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="InvestorProfileAd"
        component={InvestorProfileAd}
        durationInFrames={510}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
