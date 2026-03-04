'use client';

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
    src = '/auth-default.lottie',
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
