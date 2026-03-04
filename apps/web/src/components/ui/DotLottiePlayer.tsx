"use client";

import React from 'react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';

interface DotLottiePlayerProps {
    src?: string;
    loop?: boolean;
    autoplay?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

const DotLottiePlayer: React.FC<DotLottiePlayerProps> = ({
    src = 'https://lottie.host/6b0373c2-299a-4231-b481-abdccc1de3a5/EX5wjKeUd7.lottie',
    loop = true,
    autoplay = true,
    className,
    style,
}) => {
    return (
        <div className={className} style={style}>
            <DotLottieReact src={src} loop={loop} autoplay={autoplay} />
        </div>
    );
};

export default DotLottiePlayer;
